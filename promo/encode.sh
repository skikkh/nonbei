#!/bin/sh
# Encode the captured frames (promo/out/frames/f0000.jpg …) into the reels.
#   nonbei-reel.mp4        1080×1920, 30 fps, 30 s, H.264 High@4.2, silent AAC track (high quality)
#   nonbei-reel-light.mp4  the same at about 4.2 Mbps, for chat apps and slow uploads
#   story-1.png … story-7.png  one still per scene for Stories (from promo/capture.js stills)
set -eu
cd "$(dirname "$0")/out"
VF="scale=1080:1920:flags=lanczos:in_range=full:out_range=tv:out_color_matrix=bt709,format=yuv420p"
COLOR="-color_primaries bt709 -color_trc bt709 -colorspace bt709 -color_range tv"

ffmpeg -y -loglevel error -framerate 30 -i frames/f%04d.jpg \
  -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=48000 \
  -map 0:v -map 1:a -shortest -vf "$VF" \
  -c:v libx264 -profile:v high -level:v 4.2 -preset slow -crf 20 -g 60 -keyint_min 30 $COLOR \
  -c:a aac -b:a 128k -ar 48000 -movflags +faststart nonbei-reel.mp4

ffmpeg -y -loglevel error -framerate 30 -i frames/f%04d.jpg -vf "$VF" \
  -c:v libx264 -profile:v high -level:v 4.2 -preset slow -b:v 4200k -g 60 -pass 1 -passlogfile light -an -f mp4 /dev/null
ffmpeg -y -loglevel error -framerate 30 -i frames/f%04d.jpg \
  -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=48000 \
  -map 0:v -map 1:a -shortest -vf "$VF" \
  -c:v libx264 -profile:v high -level:v 4.2 -preset slow -b:v 4200k -maxrate 5000k -bufsize 8400k -pass 2 -passlogfile light -g 60 $COLOR \
  -c:a aac -b:a 96k -ar 48000 -movflags +faststart nonbei-reel-light.mp4
rm -f light-0.log light-0.log.mbtree

# stills: the moment each scene has settled
i=1
for t in 2.8 7.6 12.2 16.6 20.9 25.3 29.4; do
  f=$(printf "frames/f%04d.jpg" "$(awk "BEGIN{print int($t*30)}")")
  ffmpeg -y -loglevel error -i "$f" -vf "scale=1080:1920:flags=lanczos" -frames:v 1 "story-$i.png"
  i=$((i+1))
done
ffmpeg -y -loglevel error -i frames/f0882.jpg -vf "scale=1080:1920" -frames:v 1 -q:v 2 cover.jpg
ls -la nonbei-reel.mp4 nonbei-reel-light.mp4 story-*.png cover.jpg
