#!/usr/bin/env bash
# Try to get the raw source from various sources
echo "=== Trying npm view ==="
npm view pi-simple-agents@0.2.2 dist.tarball 2>/dev/null || echo "npm not available"
echo "=== Trying curl ==="
curl -sL "https://registry.npmjs.org/pi-simple-agents/0.2.2" 2>/dev/null | head -5 || echo "curl not available"