#!/bin/sh
# Copy the built site into a checkout of the skikkh.github.io repository.
#   python3 scripts/build_site.py && sh scripts/publish_pages.sh ../skikkh.github.io
# The map goes to nonbei/ (https://skikkh.github.io/nonbei/); the reel, when
# promo/out/nonbei-reel-light.mp4 exists, to nonbei/media/. Commit and push
# the checkout afterwards; GitHub Pages serves the default branch. A root
# index.html linking the maps is added when the repository has none.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
dest=${1:?usage: publish_pages.sh PATH_TO_skikkh.github.io}
[ -f "$here/dist/site/index.html" ] || { echo "run scripts/build_site.py first" >&2; exit 1; }
mkdir -p "$dest/nonbei"
rsync -a --delete --exclude media/ "$here/dist/site/" "$dest/nonbei/"
if [ -f "$here/promo/out/nonbei-reel-light.mp4" ]; then
  mkdir -p "$dest/nonbei/media"
  cp "$here/promo/out/nonbei-reel-light.mp4" "$dest/nonbei/media/nonbei-reel.mp4"
  cp "$here/promo/out/cover.jpg" "$dest/nonbei/media/nonbei-reel-cover.jpg" 2>/dev/null || true
fi
touch "$dest/.nojekyll"
[ -f "$dest/index.html" ] || cp "$here/site/pages-root/index.html" "$dest/index.html"
du -sh "$dest/nonbei"
