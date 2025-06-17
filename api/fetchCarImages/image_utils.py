import requests
from PIL import Image
from io import BytesIO
import os
import json
from azure.storage.blob import BlobServiceClient
import uuid
import random

PIXABAY_API_KEY = os.getenv("PIXABAY_API_KEY", "YOUR_PIXABAY_API_KEY")
AZURE_STORAGE_CONNECTION_STRING = os.getenv("AZURE_STORAGE_CONNECTION_STRING", "YOUR_AZURE_STORAGE_CONNECTION_STRING")
FULL_CONTAINER = "full-images"
CROPPED_CONTAINER = "cropped-details"

def fetch_and_crop_car_image():
    base_terms = [
        "audi", "bmw", "mercedes", "volkswagen", "toyota", "honda", "ford", "chevrolet",
        "nissan", "hyundai", "kia", "mazda", "subaru", "volvo", "peugeot", "renault",
        "citroen", "fiat", "jeep", "dodge", "ram", "gmc", "cadillac", "chrysler",
        "buick", "lincoln", "tesla", "porsche", "ferrari", "lamborghini", "maserati",
        "alfa romeo", "aston martin", "bentley", "rolls royce", "lotus", "jaguar",
        "land rover", "mini", "seat", "skoda", "suzuki", "saab", "opel", "smart",
        "acura", "infiniti", "lexus", "genesis", "daewoo", "dacia", "hummer",
        "isuzu", "mg", "polestar", "proton", "scion", "ssangyong", "tata", "uaz",
        "zastava", "byd", "nio", "chery", "geely", "great wall", "lancia", "lucid",
        "rivian", "vinfast"
    ]

    variants = [
        "car", "front view", "rear view", "interior", "dashboard", "side profile",
        "logo", "classic", "sports", "suv", "sedan", "electric"
    ]

    hits = []
    for _ in range(3):  # kokeillaan max 3 eri hakua
        brand = random.choice(base_terms)
        modifier = random.choice(variants)
        search_term = f"{brand} {modifier}".strip()
        page = random.randint(1, 5)

        response = requests.get(
            f"https://pixabay.com/api/?key={PIXABAY_API_KEY}&q={search_term}&image_type=photo&per_page=50&page={page}&order=latest"
        )
        data = response.json()
        hits = data.get("hits", [])
        if hits:
            break  # saatiin osumia

    # fallback haku, jos mikään ei tuottanut tulosta
    if not hits:
        fallback_term = "car"
        response = requests.get(
            f"https://pixabay.com/api/?key={PIXABAY_API_KEY}&q={fallback_term}&image_type=photo&per_page=50"
        )
        data = response.json()
        hits = data.get("hits", [])
        if not hits:
            return json.dumps({"error": "No images found, even in fallback"})

    selected = random.choice(hits)
    image_url = selected["largeImageURL"]

    image_response = requests.get(image_url)
    image = Image.open(BytesIO(image_response.content))

    # Crop a small detail from the image
    width, height = image.size
    crop_box = (width//4, height//4, width//2, height//2)
    cropped_image = image.crop(crop_box)

    # Upload both images to Azure Blob Storage
    blob_service_client = BlobServiceClient.from_connection_string(AZURE_STORAGE_CONNECTION_STRING)
    
    full_blob_name = f"{uuid.uuid4()}.jpg"
    cropped_blob_name = f"cropped_{uuid.uuid4()}.jpg"

    full_blob_client = blob_service_client.get_blob_client(container=FULL_CONTAINER, blob=full_blob_name)
    cropped_blob_client = blob_service_client.get_blob_client(container=CROPPED_CONTAINER, blob=cropped_blob_name)

    full_buffer = BytesIO()
    image.save(full_buffer, format="JPEG")
    full_buffer.seek(0)
    full_blob_client.upload_blob(full_buffer, overwrite=True)

    cropped_buffer = BytesIO()
    cropped_image.save(cropped_buffer, format="JPEG")
    cropped_buffer.seek(0)
    cropped_blob_client.upload_blob(cropped_buffer, overwrite=True)

    return json.dumps({
        "full_image_url": full_blob_client.url,
        "cropped_image_url": cropped_blob_client.url
    })

