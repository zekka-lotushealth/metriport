import { MedplumClient } from "@medplum/core";
import { Bundle, Resource } from "@medplum/fhirtypes";
import { executeWithRetriesS3, S3Utils } from "@metriport/core/external/aws/s3";
import { parseRawBundleForFhirServer } from "@metriport/core/external/fhir/parse-bundle";
import { errorToString, executeWithNetworkRetries, MetriportError } from "@metriport/shared";
import { SQSEvent } from "aws-lambda";
import fetch from "node-fetch";
import { capture } from "./shared/capture";
import { CloudWatchUtils, Metrics } from "./shared/cloudwatch";
import { getEnvOrFail } from "./shared/env";
import { Log, prefixedLog } from "./shared/log";

// Automatically set by AWS
const lambdaName = getEnvOrFail("AWS_LAMBDA_FUNCTION_NAME");
const region = getEnvOrFail("AWS_REGION");
// Set by us
const metricsNamespace = getEnvOrFail("METRICS_NAMESPACE");
const fhirServerUrl = getEnvOrFail("FHIR_SERVER_URL");

const maxRetries = 10;
const defaultS3RetriesConfig = {
  maxAttempts: 3,
  initialDelay: 500,
};

const s3Utils = new S3Utils(region);
const cloudWatchUtils = new CloudWatchUtils(region, lambdaName, metricsNamespace);

/* Example of a single message/record in event's `Records` array:
{
    "messageId": "2EBA03BC-D6D1-452B-BFC3-B1DD39F32947",
    "receiptHandle": "quite-long-string",
    "body": "{\"s3FileName\":\"nononononono\",\"s3BucketName\":\"nononono\"}",
    "attributes": {
        "ApproximateReceiveCount": "1",
        "AWSTraceHeader": "Root=1-646a7c8c-3c5f0ea61b9a8e633bfad33c;Parent=78bb05ac3530ad87;Sampled=0;Lineage=e4161027:0",
        "SentTimestamp": "1684700300546",
        "SequenceNumber": "18878027350649327616",
        "SenderId": "AROAWX27OVJFOXNNHQRAU:FHIRConverter_Retry_Lambda",
        "ApproximateFirstReceiveTimestamp": "1684700300546"
    },
    "messageAttributes": {
      cxId: {
        stringValue: '7006E0FB-33C8-42F4-B675-A3FD05717446',
        stringListValues: [],
        binaryListValues: [],
        dataType: 'String'
      }
    },
    "md5OfBody": "543u5y34ui53uih543uh5ui4",
    "eventSource": "aws:sqs",
    "eventSourceARN": "arn:aws:sqs:<region>:<acc>>:<queue-name>",
    "awsRegion": "<region>"
}
*/

type EventBody = {
  s3BucketName: string;
  s3FileName: string;
};

// Don't use Sentry's default error handler b/c we want to use our own and send more context-aware data
export async function handler(event: SQSEvent) {
  try {
    // Process messages from SQS
    const records = event.Records;
    if (!records || records.length < 1) {
      console.log(`No records, discarding this event: ${JSON.stringify(event)}`);
      return;
    }
    if (records.length > 1) {
      capture.message("Got more than one message from SQS", {
        extra: {
          event,
          context: lambdaName,
          additional: `This lambda is supposed to run w/ only 1 message per batch, got ${records.length} (still processing them all)`,
        },
      });
    }

    console.log(`Processing ${records.length} records...`);
    for (const [i, message] of records.entries()) {
      // Process one record from the SQS message
      console.log(`Record ${i}, messageId: ${message.messageId}`);
      if (!message.messageAttributes) throw new Error(`Missing message attributes`);
      if (!message.body) throw new Error(`Missing message body`);
      const attrib = message.messageAttributes;
      const cxId = attrib.cxId?.stringValue;
      const patientId = attrib.patientId?.stringValue;
      const jobId = attrib.jobId?.stringValue;
      const jobStartedAt = attrib.startedAt?.stringValue;
      if (!cxId) throw new Error(`Missing cxId`);
      if (!patientId) throw new Error(`Missing patientId`);
      const log = prefixedLog(`${i}, patient ${patientId}, job ${jobId}`);

      log(`Body: ${message.body}`);
      const { s3BucketName, s3FileName } = parseBody(message.body);
      const metrics: Metrics = {};

      log(`Getting contents from bucket ${s3BucketName}, key ${s3FileName}`);
      const downloadStart = Date.now();
      const payloadRaw = await executeWithRetriesS3(
        () => s3Utils.getFileContentsAsString(s3BucketName, s3FileName),
        {
          ...defaultS3RetriesConfig,
          log,
        }
      );
      metrics.download = {
        duration: Date.now() - downloadStart,
        timestamp: new Date(),
      };

      log(`Converting payload to JSON, length ${payloadRaw.length}`);
      const payload: Bundle = parseRawBundleForFhirServer(payloadRaw, patientId);

      log(`Sending payload to FHIRServer...`);
      let response: Bundle<Resource> | undefined;
      const upsertStart = Date.now();
      const fhirApi = new MedplumClient({
        fetch,
        baseUrl: fhirServerUrl,
        fhirUrlPath: `fhir/${cxId}`,
      });
      let count = 0;
      let retry = true;
      // This retry logic is for application level errors, not network errors
      while (retry) {
        count++;
        response = await executeWithNetworkRetries(() => fhirApi.executeBatch(payload), { log });
        const errors = getErrorsFromReponse(response);
        if (errors.length <= 0) break;
        retry = count < maxRetries;
        log(
          `Got ${errors.length} errors from FHIR, ${
            retry ? "" : "NOT "
          }trying again... errors: ${JSON.stringify(errors)}`
        );
        if (!retry) {
          throw new MetriportError(`Too many errors from FHIR`, undefined, {
            count: count.toString(),
            maxRetries: maxRetries.toString(),
          });
        }
      }
      metrics.errorCount = {
        count,
        timestamp: new Date(),
      };
      metrics.upsert = {
        duration: Date.now() - upsertStart,
        timestamp: new Date(),
      };

      if (jobStartedAt) {
        metrics.job = {
          duration: Date.now() - new Date(jobStartedAt).getTime(),
          timestamp: new Date(),
        };
      }

      processFHIRResponse(response, event, log);

      await cloudWatchUtils.reportMetrics(metrics);
    }
    console.log(`Done`);
  } catch (error) {
    const msg = "Error processing event on " + lambdaName;
    console.log(`${msg}: ${errorToString(error)}`);
    capture.error(msg, {
      extra: { event, context: lambdaName, error },
    });
    throw new MetriportError(msg, error);
  }
}

function parseBody(body: unknown): EventBody {
  const bodyString = typeof body === "string" ? (body as string) : undefined;
  if (!bodyString) throw new Error(`Invalid body`);

  const bodyAsJson = JSON.parse(bodyString);

  const s3BucketNameRaw = bodyAsJson.s3BucketName;
  if (!s3BucketNameRaw) throw new Error(`Missing s3BucketName`);
  if (typeof s3BucketNameRaw !== "string") throw new Error(`Invalid s3BucketName`);

  const s3FileNameRaw = bodyAsJson.s3FileName;
  if (!s3FileNameRaw) throw new Error(`Missing s3FileName`);
  if (typeof s3FileNameRaw !== "string") throw new Error(`Invalid s3FileName`);

  const s3BucketName = s3BucketNameRaw as string;
  const s3FileName = s3FileNameRaw as string;

  return { s3BucketName, s3FileName };
}

function getErrorsFromReponse(response?: Bundle<Resource>) {
  const entries = response?.entry ? response.entry : [];
  const errors = entries.filter(
    // returns non-2xx responses AND null/undefined
    e => !e.response?.status?.startsWith("2")
  );
  return errors;
}

function processFHIRResponse(
  response: Bundle<Resource> | undefined,
  event: SQSEvent,
  log: Log
): void {
  const entries = response?.entry ? response.entry : [];
  const errors = getErrorsFromReponse(response);
  const countError = errors.length;
  const countSuccess = entries.length - countError;
  log(`Got ${countError} errors and ${countSuccess} successes from FHIR Server`);
  if (errors.length > 0) {
    errors.forEach(e => log(`Error from FHIR Server: ${JSON.stringify(e)}`));
    capture.message(`Error upserting Bundle on FHIR server`, {
      extra: {
        context: lambdaName,
        additional: "processResponse",
        event,
        countSuccess,
        countError,
      },
      level: "error",
    });
  }
}
