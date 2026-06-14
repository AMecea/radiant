#!/bin/bash
set -eo pipefail

VIDEO_FILE="1petru_5_1_5.mp4"
OUT_FILE="1petru_5_1_5_preaiubitilor.mp4"
OUT_PATH="/video/reels/"

trap 'echo "reel-video failed (exit $?)" | telegram send' ERR

uv run clip.py \
    ${VIDEO_FILE} \
    -s 00:20:25.80 -e 00:22:25.50 \
    --crop-format tiktok \
    --output $OUT_FILE \
    --track-sample 5 --track-sigma 20 --track-face


rclone copy $OUT_FILE gs:project-files-1${OUT_PATH} --gcs-object-acl publicRead

echo "https://storage.googleapis.com/project-files-1${OUT_PATH}${OUT_FILE}" | telegram send
