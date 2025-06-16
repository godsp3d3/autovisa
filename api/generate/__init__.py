import logging
import os
import azure.functions as func
from azure.storage.blob import BlobServiceClient, ContentSettings
import requests
import json
from PIL import Image
from io import BytesIO
import random

def main(req: func.HttpRequest) -> func.HttpResponse:
    pixabay_key = os.getenv("25847901-62649e7ddebbf0c8586b48e7b")
    storage_conn = os.getenv("DefaultEndpointsProtocol=https;AccountName=autovisa;AccountKey=SMBmwO/BCf0iInnCSrwLc8H78E60mGeQzAiydSyb6gMoYw3QaGXoEVCJFliCLs1c7QDMZHX184Ky+AStvRYbRg==;EndpointSuffix=core.windows.net")
    container_name = "images"
    blob_service_client = BlobServiceClient.from_connection_string(storage_conn)
    container_client = blob_service_client.get_container_client(container_name)

    response = requests.get("https://pixabay.com/api/", params={
        "key": pixabay_key,
        "q": "car",
        "image_type": "photo",
        "per_page": 20,
        "safesearch": "true"
    })
    data = response.json().get("hits", [])
    result_metadata = []

    for i, img in enumerate(data):
        image_url = img.get('largeImageURL')
        tags = img.get('tags', 'Tuntematon auto')

        r = requests.get(image_url)
        image = Image.open(BytesIO(r.content))
        if image.mode == 'RGBA':
            image = image.convert('RGB')

        width, height = image.size
        cw, ch = width // 3, height // 3
        left, top = random.randint(0, width - cw), random.randint(0, height - ch)
        cropped = image.crop((left, top, left + cw, top + ch))

        if cropped.mode == 'RGBA':
            cropped = cropped.convert('RGB')

        large_name = f'q{i+1}_iso.jpg'
        small_name = f'q{i+1}_pieni.jpg'

        buffer_large = BytesIO()
        buffer_small = BytesIO()
        image.save(buffer_large, format='JPEG')
        cropped.save(buffer_small, format='JPEG')

        for name, buf in [(large_name, buffer_large), (small_name, buffer_small)]:
            blob = container_client.get_blob_client(name)
            blob.upload_blob(buf.getvalue(), overwrite=True, content_settings=ContentSettings(content_type='image/jpeg'))

        result_metadata.append({
            "id": i + 1,
            "answer": tags,
            "small": small_name,
            "large": large_name
        })

    json_blob = container_client.get_blob_client("data.json")
    json_blob.upload_blob(json.dumps(result_metadata, indent=2, ensure_ascii=False), overwrite=True, content_settings=ContentSettings(content_type='application/json'))

    return func.HttpResponse(json.dumps({"status": "OK", "questions": len(result_metadata)}), mimetype="application/json")
