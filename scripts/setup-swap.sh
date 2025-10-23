#!/bin/bash

# Setup swap file for 2GB RAM Ubuntu server
# This adds 2GB of swap space to help with memory-intensive builds

echo "Setting up swap file for better build performance..."

# Check if swap already exists
if swapon --show | grep -q "/swapfile"; then
    echo "Swap file already exists"
    exit 0
fi

# Create 2GB swap file
sudo fallocate -l 2G /swapfile

# Set correct permissions
sudo chmod 600 /swapfile

# Make it a swap file
sudo mkswap /swapfile

# Enable the swap file
sudo swapon /swapfile

# Make it permanent
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# Optimize swappiness for build performance
echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf

# Show current memory and swap
echo "Memory and swap status:"
free -h

echo "Swap setup complete!"
echo "Reboot recommended to apply all settings"
