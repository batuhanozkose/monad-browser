#!/bin/sh
# Dev helper: unpack Debian's chromium + missing libs without root (sandbox/CI use).
# Usage: scripts/dev-chromium-rootless.sh [DEST]  → prints path of a launcher to use as MONAD_CHROME.
set -e
DEST=${1:-/workspace/tools/chromium}
mkdir -p "$DEST/root" /tmp/mb-debs /tmp/mb-apt/lists/partial /tmp/mb-apt/cache/partial && cd /tmp/mb-debs
APTO="-o Dir::State::Lists=/tmp/mb-apt/lists -o Dir::Cache=/tmp/mb-apt/cache -o Debug::NoLocking=1"
apt-get $APTO update >/dev/null 2>&1 || true
apt-get $APTO download chromium chromium-common libopenh264-8 libatk1.0-0t64 libatk-bridge2.0-0t64 libdouble-conversion3 \
  libharfbuzz-subset0 libxnvctrl0 libxcomposite1 libxdamage1 libatspi2.0-0t64 libminizip1t64 >/dev/null
for f in *.deb; do dpkg-deb -x "$f" "$DEST/root"; done
rm -rf /tmp/mb-debs
cat > "$DEST/chromium" <<EOS
#!/bin/sh
export LD_LIBRARY_PATH=$DEST/root/usr/lib/aarch64-linux-gnu:$DEST/root/usr/lib/x86_64-linux-gnu:\$LD_LIBRARY_PATH
exec $DEST/root/usr/lib/chromium/chromium "\$@"
EOS
chmod +x "$DEST/chromium"
echo "$DEST/chromium"
