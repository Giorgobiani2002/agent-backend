import path from "path";
import { randomUUID } from "crypto";
import { Storage } from "@google-cloud/storage";
import { config } from "../config";
import { getVertexCredentials } from "../services/vertex";

let storage: Storage | null = null;

function getStorage() {
  if (!storage) {
    const credentials = getVertexCredentials();
    storage = new Storage({
      projectId: config.gcpProjectId,
      ...(credentials ? { credentials } : {}),
    });
  }
  return storage;
}

export async function uploadVertexMedia(input: {
  filePath: string;
  displayName: string;
  mimeType: string;
}): Promise<{ uri: string; cleanup: () => Promise<void> }> {
  const safeName = path.basename(input.displayName).replace(/[^a-zA-Z0-9._-]+/g, "-");
  const objectName = `playbook-media/${Date.now()}-${randomUUID()}-${safeName}`;
  const bucket = getStorage().bucket(config.gcpMediaBucket);

  await bucket.upload(input.filePath, {
    destination: objectName,
    metadata: { contentType: input.mimeType },
    resumable: true,
    validation: "crc32c",
  });

  return {
    uri: `gs://${config.gcpMediaBucket}/${objectName}`,
    cleanup: async () => {
      await bucket.file(objectName).delete({ ignoreNotFound: true });
    },
  };
}
