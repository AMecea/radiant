#!/bin/bash
set -eo pipefail

#IN_RAW_FILE="/Volumes/RADIANT/A235_11162312_C003.braw" # Disk 1
#IN_RAW_FILE="/Volumes/RADIANT TM/A232_11100825_C005.braw" # Disk 2
IN_RAW_FILE="/Volumes/RADIANT TM/A232_11230825_C006.braw" # Disk 2
IN_AUDIO_FILE="./resources/R_20260607-110727.wav"
VIDEO_FILE="1petru_5_1_5.mp4"
RUN_VERSION="02"

OUT_PATH="project-files-1/video/$(date +%Y-%m-%d)-${RUN_VERSION}/"
URL="https://storage.googleapis.com/${OUT_PATH}${VIDEO_FILE}"

trap 'echo "extract-video failed (exit $?)" | telegram send' ERR

caffeinate -t 3600 -i uv run process_video.py  \
    "$IN_RAW_FILE" \
    "$IN_AUDIO_FILE" \
    --output "${VIDEO_FILE}" \
    --hw \
    --upload gs:$OUT_PATH --upload-public \
    # --test-duration 30 \
    --braw-threads 10 \
        2>&1 | tee >(telegram watch -i 10) 

echo "extract-video finished. URL: $URL" | telegram send
