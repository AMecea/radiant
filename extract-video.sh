#/bin/bash


#IN_RAW_FILE="/Volumes/RADIANT/A235_11040034_C001.braw"
IN_RAW_FILE="/Volumes/RADIANT TM/A232_11100825_C005.braw"
IN_AUDIO_FILE="./resources/R_20260524-105851_2.wav"
VIDEO_FILE="1petru_4_7_11.mp4"
RUN_VERSION="02"


caffeinate -t 3600 -i uv run process_video.py  \
    "$IN_RAW_FILE" \
    "$IN_AUDIO_FILE" \
    --output "${VIDEO_FILE}" \
    --hw \
    --upload gs:project-files-1/video/$(date +%Y-%m-%d)-${RUN_VERSION}/ --upload-public \
    --braw-threads 10  # --test-duration 30




