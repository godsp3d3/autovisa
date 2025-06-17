import logging
import azure.functions as func
from .image_utils import fetch_and_crop_car_image

def main(req: func.HttpRequest) -> func.HttpResponse:
    logging.info("Processing request to fetch and crop car image.")
    
    try:
        result = fetch_and_crop_car_image()
        return func.HttpResponse(result, mimetype="application/json")
    except Exception as e:
        logging.error(f"Error: {e}")
        return func.HttpResponse(f"Error: {str(e)}", status_code=500)
