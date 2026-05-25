#!/bin/bash

VIDEO_FILE="1petru_4_7_11.mp4"
OUT_FILE="1petru_4_7_11_noi_spunem_adesea.mp4"
OUT_PATH="/video/2026-05-24-02/"

uv run clip.py \
    ${VIDEO_FILE} \
    -s 00:08:00 -e 00:09:28 \
    --crop-format tiktok \
    --output $OUT_FILE \
    --track-sample 5 --track-sigma 20 --track-face


rclone copy $OUT_FILE gs:project-files-1${OUT_PATH} --gcs-object-acl publicRead

echo "https://storage.googleapis.com/project-files-1${OUT_PATH}${OUT_FILE}"
