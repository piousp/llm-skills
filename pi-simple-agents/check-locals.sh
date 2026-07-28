#!/bin/bash
echo "=== node_modules ==="
ls node_modules/pi-simple-agents/ 2>/dev/null || echo "not installed"
echo "=== package.json ==="
cat package.json 2>/dev/null | head -20