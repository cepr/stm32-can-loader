# stm32-can-loader
Firmware loader for the STM32 CAN bootloader (AN3154)

This only supports Linux and a CAN adapter compatible with *socketcan*.

# Installation

This program requires NodeJS 18 or above.

    npm install -g

# Usage 

`$ stm32-can-loader -h`

    stm32-can-loader [--help] [--device <device>] --write myfirmware.elf

    --help   -h  Display this help screen.
    --device -d  Specifies the SocketCAN device to use. Default: can0
    --write  -w  Specifies a firmware in ELF format to flash.

    This program will flash, verify and start the firmware automatically.
    You must configure the SocketCAN (bitrate and up) before running this program.

Make sure to configure your socketcan device before:

    sudo ip link set down can0
    sudo ip link set can0 type can bitrate 125000
    sudo ip link set up can0

`$ stm32-can-loader -w instruments.elf`

    Flashing instruments.elf using can0...
     ████████████████████████████████████████ 100% | ETA: 0s | 19759/19759
    Done.
