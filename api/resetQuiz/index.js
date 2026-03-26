"use strict";

const { BlobServiceClient } = require("@azure/storage-blob");

module.exports = async function (context, req) {
  context.log("Processing request to reset quiz by deleting blobs.");

  try {
    const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
    const containerNames = (process.env.BLOB_CONTAINER_NAMES || "").split(",").map((s) => s.trim()).filter(Boolean);

    if (!connectionString) throw new Error("AZURE_STORAGE_CONNECTION_STRING is not set");
    if (!containerNames.length) throw new Error("BLOB_CONTAINER_NAMES is not set");

    const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);

    for (const containerName of containerNames) {
      const containerClient = blobServiceClient.getContainerClient(containerName);
      for await (const blob of containerClient.listBlobsFlat()) {
        await containerClient.deleteBlob(blob.name);
        context.log(`Deleted blob: ${blob.name} from ${containerName}`);
      }
    }

    context.res = { status: 200, body: "Blobs deleted successfully." };
  } catch (err) {
    context.log.error("Error resetting quiz:", err.message);
    context.res = { status: 500, body: `Error: ${err.message}` };
  }
};
