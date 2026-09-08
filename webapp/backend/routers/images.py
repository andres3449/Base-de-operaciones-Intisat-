# -*- coding: utf-8 -*-
import os

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from .. import headless_config

router = APIRouter(prefix="/api", tags=["images"])


@router.get("/images")
def list_images():
    images_dir = headless_config.read_images_dir()
    if not os.path.isdir(images_dir):
        return {"images": []}
    rows = []
    for name in os.listdir(images_dir):
        if not name.lower().endswith((".jpg", ".jpeg")):
            continue
        path = os.path.join(images_dir, name)
        stat = os.stat(path)
        rows.append({
            "filename": name,
            "size_bytes": stat.st_size,
            "modified": stat.st_mtime,
        })
    rows.sort(key=lambda r: r["modified"], reverse=True)
    return {"images": rows}


@router.get("/images/{filename}")
def get_image(filename: str):
    if "/" in filename or "\\" in filename or ".." in filename:
        raise HTTPException(400, "invalid filename")
    images_dir = headless_config.read_images_dir()
    path = os.path.join(images_dir, filename)
    if not os.path.isfile(path):
        raise HTTPException(404, "not found")
    return FileResponse(path, media_type="image/jpeg")
