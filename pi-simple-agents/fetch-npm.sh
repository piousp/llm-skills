#!/usr/bin/env bash
# Intentar ver el contenido de v0.2.2 desde npm
npm pack pi-simple-agents@0.2.2 --pack-destination /tmp/psa-pack 2>/dev/null
if [ -f /tmp/psa-pack/pi-simple-agents-0.2.2.tgz ]; then
  tar -xzf /tmp/psa-pack/pi-simple-agents-0.2.2.tgz -C /tmp/psa-pack
  cat /tmp/psa-pack/package/src/agents.ts 2>/dev/null || echo "Not found in extracted"
fi