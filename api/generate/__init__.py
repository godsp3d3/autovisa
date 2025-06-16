import json
import os
import logging
import azure.functions as func
from azure.storage.blob import BlobServiceClient
import requests
from PIL import Image
from io import BytesIO
import random
import uuid

PIXABAY_API_KEY = os.getenv("25847901-62649e7ddebbf0c8586b48e7b")
STORAGE_CONN_STRING = os.getenv("DefaultEndpointsProtocol=https;AccountName=autovisa;AccountKey=SMBmwO/BCf0iInnCSrwLc8H78E60mGeQzAiydSyb6gMoYw3QaGXoEVCJFliCLs1c7QDMZHX184Ky+AStvRYbRg==;EndpointSuffix=core.windows.net")
CONTAINER_NAME = "images"

def main(req: func.HttpRequest) -> func.HttpResponse:
    try:
        query = "classic car"
        count = 20
        url = f"https://pixabay.com/api/?key={PIXABAY_API_KEY}&q={query}&image_type=photo&per_page=50"
        res = requests.get(url)
        items = res.json().get("hits", [])
        selected = random.sample(items, k=min(count, len(items)))

        blob_service_client = BlobServiceClient.from_connection_string(STORAGE_CONN_STRING)
        container_client = blob_service_client.get_container_client(CONTAINER_NAME)

        metadata = []

        for item in selected:
            image_url = item["largeImageURL"]
            image_id = str(uuid.uuid4())

            img_res = requests.get(image_url)
            img = Image.open(BytesIO(img_res.content)).convert("RGB")

            # Leikkaa satunnainen 300x300 alue
            w, h = img.size
            x = random.randint(0, max(0, w - 300))
            y = random.randint(0, max(0, h - 300))
            cropped = img.crop((x, y, x + 300, y + 300))

            # Tallenna leikattu kuva blobiin
            cropped_bytes = BytesIO()
            cropped.save(cropped_bytes, format="JPEG")
            cropped_bytes.seek(0)

            blob_path = f"{image_id}.jpg"
            container_client.upload_blob(blob_path, cropped_bytes, overwrite=True)

            metadata.append({
                "id": image_id,
                "url": f"https://autovisa.blob.core.windows.net/{CONTAINER_NAME}/{blob_path}",
                "full_url": image_url
            })

        return func.HttpResponse(json.dumps(metadata), mimetype="application/json")

    except Exception as e:
        logging.error(f"Virhe visan generoinnissa: {e}")
        return func.HttpResponse(json.dumps({"status": "ERROR", "message": str(e)}),
                                 status_code=500,
                                 mimetype="application/json")
