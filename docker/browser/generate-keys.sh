#!/bin/bash
ssh-keygen -A 2>/dev/null
mkdir -p /home/tunnel/.ssh
chown -R tunnel:tunnel /home/tunnel/.ssh
chmod 700 /home/tunnel/.ssh
[ -f /home/tunnel/.ssh/authorized_keys ] && chmod 600 /home/tunnel/.ssh/authorized_keys
