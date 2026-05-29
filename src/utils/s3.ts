import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { config } from "../config";

let s3Client: S3Client | null = null;

function getS3Client(): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({
      endpoint: config.s3Endpoint,
      region: config.s3Region,
      credentials: {
        accessKeyId: config.s3AccessKeyId,
        secretAccessKey: config.s3SecretAccessKey,
      },
      forcePathStyle: true,
    });
  }
  return s3Client;
}

export async function uploadScreenshot(
  imageBuffer: Buffer,
  key: string,
  contentType: string,
): Promise<string> {
  const client = getS3Client();

  await client.send(
    new PutObjectCommand({
      Bucket: config.s3Bucket,
      Key: key,
      Body: imageBuffer,
      ContentType: contentType,
    }),
  );

  return `${config.s3Endpoint}/${config.s3Bucket}/${key}`;
}
