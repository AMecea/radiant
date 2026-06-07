#!/bin/bash

VIDEO_FILE="1petru_4_12_17.mp4"
OUT_FILE="1petru_4_12_17_de_acceea.mp4"
OUT_PATH="/video/2026-05-31-02/"

uv run clip.py \
    ${VIDEO_FILE} \
    -s 00:15:00.30 -e 00:16:05.60 \
    --crop-format tiktok \
    --output $OUT_FILE \
    #--track-sample 5 --track-sigma 20 --track-face


rclone copy $OUT_FILE gs:project-files-1${OUT_PATH} --gcs-object-acl publicRead

echo "https://storage.googleapis.com/project-files-1${OUT_PATH}${OUT_FILE}"
