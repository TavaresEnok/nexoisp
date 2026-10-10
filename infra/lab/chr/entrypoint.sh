#!/bin/sh
set -e
[ -f /images/chr.img ] || { echo "falta /images/chr.img (imagem CHR oficial)"; exit 1; }
cp /images/chr.img /run/chr.img            # disco descartável: cada subida parte da imagem limpa
ip tuntap add dev tap0 mode tap
ip link set tap0 up
exec qemu-system-x86_64 -enable-kvm -cpu host -m 256 -display none \
  -serial telnet:127.0.0.1:5000,server,nowait \
  -drive file=/run/chr.img,format=raw,if=virtio \
  -netdev user,id=mgmt,hostfwd=tcp::8728-:8728,hostfwd=tcp::8729-:8729 -device virtio-net-pci,netdev=mgmt \
  -netdev tap,id=subs,ifname=tap0,script=no,downscript=no -device virtio-net-pci,netdev=subs
