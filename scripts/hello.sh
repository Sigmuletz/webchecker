#!/bin/bash
echo "Hello from shellgate!"
echo "Date: $(date)"
echo "User: $(whoami)"
echo "Hostname: $(hostname)"
for i in 1 2 3; do
  echo "Step $i..."
  sleep 0.3
done
echo "Done."
