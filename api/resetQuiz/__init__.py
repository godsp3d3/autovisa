import logging
import os
from azure.storage.blob import BlobServiceClient
import azure.functions as func

def main(req: func.HttpRequest) -> func.HttpResponse:
    logging.info("Processing request to reset quiz by deleting blobs.")

    try:
        connection_string = os.environ["AZURE_STORAGE_CONNECTION_STRING"]
        container_names = os.environ["BLOB_CONTAINER_NAMES"].split(",")

        blob_service_client = BlobServiceClient.from_connection_string(connection_string)

        for container_name in container_names:
            container_client = blob_service_client.get_container_client(container_name)
            blobs = container_client.list_blobs()

            for blob in blobs:
                container_client.delete_blob(blob.name)
                logging.info(f"Deleted blob: {blob.name} from container: {container_name}")

        return func.HttpResponse("Blobs deleted successfully.", status_code=200)

    except Exception as e:
        logging.error(f"Error resetting quiz: {e}")
        return func.HttpResponse(f"Error: {str(e)}", status_code=500)
