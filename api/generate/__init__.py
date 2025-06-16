import json
import os
import logging
import azure.functions as func
from azure.storage.blob import BlobServiceClient
import requests
from PIL import Image
from io import BytesIO
import uuid
import random

PIXABAY_API_KEY = os.getenv("PIXABAY_API_KEY")
STORAGE_CONN_STRING = os.getenv("AZURE_STORAGE_CONNECTION_STRING")
CONTAINER_NAME = "images"

def main(req: func.HttpRequest) -> func.HttpResponse:
    try:
        if not PIXABAY_API_KEY or not STORAGE_CONN_STRING:
            return func.HttpResponse("Puuttuva ympäristömuuttuja", status_code=500)

        url = f"https://pixabay.com/api/?key={PIXABAY_API_KEY}&q=car&image_type=photo&per_page=50"
        res = requests.get(url)
        items = res.json().get("hits", [])
        selected = random.sample(items, k=min(20, len(items)))

        blob_service_client = BlobServiceClient.from_connection_string(STORAGE_CONN_STRING)
        container_client = blob_service_client.get_container_client(CONTAINER_NAME)

        result = []

        for item in selected:
            image_url = item["largeImageURL"]
            image_id = str(uuid.uuid4())

            img_res = requests.get(image_url)
            img = Image.open(BytesIO(img_res.content)).convert("RGB")

            w, h = img.size
            x = random.randint(0, max(0, w - 300))
            y = random.randint(0, max(0, h - 300))
            cropped = img.crop((x, y, x + 300, y + 300))

            buffer = BytesIO()
            cropped.save(buffer, format="JPEG")
            buffer.seek(0)

            blob_path = f"{image_id}.jpg"
            container_client.upload_blob(blob_path, buffer, overwrite=True)

            result.append({
                "id": image_id,
                "url": f"https://autovisa.blob.core.windows.net/images/{blob_path}",
                "full_url": image_url
            })

        return func.HttpResponse(json.dumps(result), mimetype="application/json")

    except Exception as e:
        logging.error(f"Virhe: {e}")
        return func.HttpResponse("Virhe visan luonnissa", status_code=500)

