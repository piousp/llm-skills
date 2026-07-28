#!/bin/bash
echo "=== node version ==="
node --version 2>&1
echo "=== node_modules exists? ==="
ls -d /home/pablo/LLMs/pi-simple-agents/node_modules 2>&1
echo "=== test run ==="
cd /home/pablo/LLMs/pi-simple-agents && node --experimental-strip-types --test 2>&1
echo "=== done ==="