import json
import logging
import os
import random
import uuid
from io import BytesIO
from typing import Dict, List, Optional, Tuple

import requests
from azure.storage.blob import BlobServiceClient
from PIL import Image
from ultralytics import YOLO

PIXABAY_API_KEY = os.getenv("PIXABAY_API_KEY", "")
AZURE_STORAGE_CONNECTION_STRING = os.getenv("AZURE_STORAGE_CONNECTION_STRING", "")
FULL_CONTAINER = os.getenv("FULL_CONTAINER", "full-images")
CROPPED_CONTAINER = os.getenv("CROPPED_CONTAINER", "cropped-details")

YOLO_MODEL_NAME = os.getenv("YOLO_MODEL_NAME", "yolov8n.pt")
YOLO_CONFIDENCE = float(os.getenv("YOLO_CONFIDENCE", "0.35"))
MIN_CAR_AREA_RATIO = float(os.getenv("MIN_CAR_AREA_RATIO", "0.18"))
MAX_PERSON_TO_CAR_AREA_RATIO = float(os.getenv("MAX_PERSON_TO_CAR_AREA_RATIO", "1.15"))
MAX_FETCH_ATTEMPTS = int(os.getenv("MAX_FETCH_ATTEMPTS", "12"))
REQUEST_TIMEOUT = int(os.getenv("REQUEST_TIMEOUT", "20"))

CAR_CLASSES = {"car", "truck", "bus", "motorcycle"}
REJECT_IF_DOMINATED_BY_PERSON = os.getenv("REJECT_IF_DOMINATED_BY_PERSON", "true").lower() == "true"

BRANDS = [
    "audi", "bmw", "mercedes", "volkswagen", "toyota", "honda", "ford", "chevrolet",
    "nissan", "hyundai", "kia", "mazda", "subaru", "volvo", "peugeot", "renault",
    "citroen", "fiat", "jeep", "dodge", "ram", "gmc", "cadillac", "chrysler",
    "buick", "lincoln", "tesla", "porsche", "ferrari", "lamborghini", "maserati",
    "alfa romeo", "aston martin", "bentley", "rolls royce", "lotus", "jaguar",
    "land rover", "mini", "seat", "skoda", "suzuki", "saab", "opel", "smart",
    "acura", "infiniti", "lexus", "genesis", "daewoo", "dacia", "hummer",
    "isuzu", "mg", "polestar", "proton", "scion", "ssangyong", "tata", "uaz",
    "zastava", "byd", "nio", "chery", "geely", "great wall", "lancia", "lucid",
    "rivian", "vinfast",
]

ACCEPTED_KEYWORDS = {"car", "auto", "automobile", "vehicle", "cars", "transport", "sedan", "suv", "coupe"}

_MODEL: Optional[YOLO] = None
_SESSION = requests.Session()


def get_model() -> YOLO:
    global _MODEL
    if _MODEL is None:
        logging.info("Loading YOLO model: %s", YOLO_MODEL_NAME)
        _MODEL = YOLO(YOLO_MODEL_NAME)
    return _MODEL


def fetch_and_crop_car_image() -> str:
    ensure_configuration()
    blob_service_client = BlobServiceClient.from_connection_string(AZURE_STORAGE_CONNECTION_STRING)

    for attempt in range(1, MAX_FETCH_ATTEMPTS + 1):
        candidate = find_candidate_image(attempt)
        if not candidate:
            continue

        image = download_image(candidate["image_url"])
        detection = detect_best_vehicle(image)
        if not detection:
            logging.info("Attempt %s rejected: no acceptable vehicle detected", attempt)
            continue

        crop_box = build_crop_box(image.size, detection["xyxy"])
        cropped_image = image.crop(crop_box)

        full_url = upload_image(blob_service_client, image, FULL_CONTAINER, suffix="full")
        cropped_url = upload_image(blob_service_client, cropped_image, CROPPED_CONTAINER, suffix="crop")

        return json.dumps(
            {
                "full_image_url": full_url,
                "cropped_image_url": cropped_url,
                "source": candidate["source"],
                "brand_query": candidate["brand_query"],
                "detected_label": detection["label"],
                "confidence": round(detection["confidence"], 4),
                "car_area_ratio": round(detection["area_ratio"], 4),
            }
        )

    return json.dumps(
        {
            "error": "No suitable car image found after validation.",
            "attempts": MAX_FETCH_ATTEMPTS,
        }
    )


def ensure_configuration() -> None:
    missing = []
    if not PIXABAY_API_KEY:
        missing.append("PIXABAY_API_KEY")
    if not AZURE_STORAGE_CONNECTION_STRING:
        missing.append("AZURE_STORAGE_CONNECTION_STRING")
    if missing:
        raise RuntimeError(f"Missing required environment variables: {', '.join(missing)}")


def find_candidate_image(attempt: int) -> Optional[Dict[str, str]]:
    brand = random.choice(BRANDS)
    page = random.randint(1, 3)
    search_term = f"{brand} car"

    response = _SESSION.get(
        "https://pixabay.com/api/",
        params={
            "key": PIXABAY_API_KEY,
            "q": search_term,
            "image_type": "photo",
            "category": "transportation",
            "safesearch": "true",
            "orientation": "horizontal",
            "per_page": 50,
            "page": page,
            "order": "popular",
        },
        timeout=REQUEST_TIMEOUT,
    )
    response.raise_for_status()
    data = response.json()

    results = data.get("hits", [])
    filtered_hits = [hit for hit in results if has_useful_tags(hit.get("tags", ""))]
    if not filtered_hits:
        logging.info("Attempt %s for '%s' returned no tag-matching hits", attempt, search_term)
        return None

    selected = random.choice(filtered_hits)
    return {
        "image_url": selected["largeImageURL"],
        "source": "pixabay",
        "brand_query": brand,
    }


def has_useful_tags(tags: str) -> bool:
    tag_set = {tag.strip().lower() for tag in tags.split(",") if tag.strip()}
    return bool(tag_set & ACCEPTED_KEYWORDS)


def download_image(url: str) -> Image.Image:
    response = _SESSION.get(url, timeout=REQUEST_TIMEOUT)
    response.raise_for_status()
    image = Image.open(BytesIO(response.content)).convert("RGB")
    return image


def detect_best_vehicle(image: Image.Image) -> Optional[Dict[str, object]]:
    model = get_model()
    results = model.predict(image, conf=YOLO_CONFIDENCE, verbose=False)
    if not results:
        return None

    result = results[0]
    if result.boxes is None or len(result.boxes) == 0:
        return None

    width, height = image.size
    image_area = width * height
    names = result.names

    best_car = None
    largest_person_area_ratio = 0.0

    for box in result.boxes:
        cls_id = int(box.cls[0].item())
        label = names.get(cls_id, str(cls_id))
        confidence = float(box.conf[0].item())
        x1, y1, x2, y2 = [float(v) for v in box.xyxy[0].tolist()]
        area_ratio = max(0.0, (x2 - x1) * (y2 - y1) / image_area)

        if label == "person":
            largest_person_area_ratio = max(largest_person_area_ratio, area_ratio)

        if label in CAR_CLASSES and area_ratio >= MIN_CAR_AREA_RATIO:
            candidate = {
                "label": label,
                "confidence": confidence,
                "xyxy": (x1, y1, x2, y2),
                "area_ratio": area_ratio,
            }
            if best_car is None or candidate["area_ratio"] > best_car["area_ratio"]:
                best_car = candidate

    if not best_car:
        return None

    if REJECT_IF_DOMINATED_BY_PERSON and largest_person_area_ratio > 0:
        if largest_person_area_ratio > best_car["area_ratio"] * MAX_PERSON_TO_CAR_AREA_RATIO:
            logging.info(
                "Rejected image because person dominates the frame (person=%.3f, car=%.3f)",
                largest_person_area_ratio,
                best_car["area_ratio"],
            )
            return None

    return best_car


def build_crop_box(image_size: Tuple[int, int], xyxy: Tuple[float, float, float, float]) -> Tuple[int, int, int, int]:
    width, height = image_size
    x1, y1, x2, y2 = xyxy

    box_width = x2 - x1
    box_height = y2 - y1

    padding_x = box_width * 0.12
    padding_y = box_height * 0.12

    crop_left = max(0, int(x1 + padding_x))
    crop_top = max(0, int(y1 + padding_y))
    crop_right = min(width, int(x2 - padding_x))
    crop_bottom = min(height, int(y2 - padding_y))

    min_width = max(120, int(width * 0.12))
    min_height = max(120, int(height * 0.12))

    if crop_right - crop_left < min_width:
        center_x = int((x1 + x2) / 2)
        half_w = min_width // 2
        crop_left = max(0, center_x - half_w)
        crop_right = min(width, center_x + half_w)

    if crop_bottom - crop_top < min_height:
        center_y = int((y1 + y2) / 2)
        half_h = min_height // 2
        crop_top = max(0, center_y - half_h)
        crop_bottom = min(height, center_y + half_h)

    return crop_left, crop_top, crop_right, crop_bottom


def upload_image(blob_service_client: BlobServiceClient, image: Image.Image, container: str, suffix: str) -> str:
    blob_name = f"{suffix}_{uuid.uuid4()}.jpg"
    blob_client = blob_service_client.get_blob_client(container=container, blob=blob_name)

    buffer = BytesIO()
    image.save(buffer, format="JPEG", quality=92)
    buffer.seek(0)

    blob_client.upload_blob(buffer, overwrite=True, content_type="image/jpeg")
    return blob_client.url
