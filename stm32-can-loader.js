#!/usr/bin/env node
//
// Copyright 2023 Cedric Priscal
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//

// Node packages
const { Buffer } = require("node:buffer");
const { parseArgs } = require("node:util");
const { exit } = require("node:process");
const { readFileSync } = require('node:fs');

// Third-party packages
const elfy = require('elfy');
const can = require('socketcan');
const cliProgress = require('cli-progress');

const options = {
    device: {
        type: "string",
        short: "d",
        default: "can0"
    },
    write: {
        type: "string",
        short: "w",
    },
    help: {
        type: "boolean",
        short: "h"
    }
}

function usage() {
    console.info("stm32-can-loader [--help] [--device <device>] --write myfirmware.elf");
    console.info("");
    console.info(" --help   -h  Display this help screen.")
    console.info(` --device -d  Specifies the SocketCAN device to use. Default: ${options.device.default}`);
    console.info(` --write  -w  Specifies a firmware in ELF format to flash.`);
    console.info();
    console.info("This program will flash, verify and start the firmware automatically.");
    console.info("You must configure the SocketCAN (bitrate and up) before running this program.");
}

const { values } = parseArgs({ options, args: process.args });

if (values.help) {
    usage();
    exit(0);
}

if (!values.write) {
    console.error("Missing argument: --write");
    usage();
    exit(1);
}

console.info(`Flashing ${values.write} using ${values.device}...`);

const channel = can.createRawChannel(values.device, true);
const firmware = elfy.parse(readFileSync(values.write));

// Concatenate all ROM segments
let addr = 0x08000000;
let data = [];
for (let program of firmware.body.programs) {
    const gap = program.paddr - (addr + data.length);
    if (gap < 0) {
        // TODO sort programs
        console.error("ERROR: the ELF segments are not in order.");
        exit(1);
    }
    if (gap != 0) {
        // TODO support non-contiguous programs
        console.error("ERROR: this program does not support non-contiguous segments.")
        exit(1);
    }
    // Concatenate
    data = [...data, ...program.data]
}
// Pad the firmware to make it a multiple of 8 bytes
while (data.length & 7) data.push(0xff);

let attempts = 10;
const commands = [];

// Connect
commands.push({
    tx: {
        id: 0x79,
        data: []
    }
}, {
    rx: {
        id: 0x79,
        data: [0x79],
        timeout: 100,
        jump: -1,
        message: "Error connecting to bootloader"
    }
});

// Erase
commands.push({
    tx: {
        id: 0x43,
        data: [0xff]
    }
}, {
    rx: {
        id: 0x43,
        data: [0x79],
        timeout: 1000,
        jump: -1,
        message: "Error while erasing (first ACK not received)"
    }
}, {
    rx: {
        id: 0x43,
        data: [0x79],
        timeout: 1000,
        jump: -1,
        message: "Error while erasing (second ACK not received)"
    }
});


// Flash
// Split the program data in chunks of 256 bytes
for (let offset256 = 0; offset256 < data.length; offset256 += 256) {
    const addr256 = addr + offset256;
    const chunk256 = data.slice(offset256, offset256 + 256);
    commands.push({
        tx: {
            id: 0x31,
            data: [
                (addr256 >> 24) & 0xff,
                (addr256 >> 16) & 0xff,
                (addr256 >> 8) & 0xff,
                addr256 & 0xff,
                chunk256.length - 1
            ]
        }
    }, {
        rx: {
            id: 0x31,
            data: [0x79],
            timeout: 1000,
            jump: -1,
            message: `Error uploading ${chunk256.length} bytes to 0x${addr256.toString(16).padStart(8, '0')}`
        }
    })
    for (let offset8 = 0; offset8 < chunk256.length; offset8 += 8) {
        commands.push({
            tx: {
                id: 0x04,
                data: chunk256.slice(offset8, offset8 + 8)
            }
        }, {
            rx: {
                id: 0x31,
                data: [0x79],
                timeout: 1000,
                message: `Error uploading 8 bytes to 0x${(addr256 + offset8).toString(16).padStart(8, '0')}`
            }
        })
    }
    commands.push({
        rx: {
            id: 0x31,
            data: [0x79],
            timeout: 1000,
            message: `Error flashing ${chunk256.length} bytes to 0x${addr256.toString(16).padStart(8, '0')}`
        }
    })
}

// Verify
// Split the program data in chunks of 256 bytes
for (let offset256 = 0; offset256 < data.length; offset256 += 256) {
    const addr256 = addr + offset256;
    const chunk256 = data.slice(offset256, offset256 + 256);
    commands.push({
        tx: {
            id: 0x11,
            data: [
                (addr256 >> 24) & 0xff,
                (addr256 >> 16) & 0xff,
                (addr256 >> 8) & 0xff,
                addr256 & 0xff,
                chunk256.length - 1
            ]
        }
    }, {
        rx: {
            id: 0x11,
            data: [0x79],
            timeout: 1000,
            jump: -1,
            message: `Error verifying ${chunk256.length} bytes at 0x${addr256.toString(16).padStart(8, '0')}`
        }
    })
    for (let offset8 = 0; offset8 < chunk256.length; offset8 += 8) {
        commands.push({
            rx: {
                id: 0x11,
                data: chunk256.slice(offset8, offset8 + 8),
                timeout: 1000,
                message: `Error verifying 8 bytes at 0x${(addr256 + offset8).toString(16).padStart(8, '0')}`
            }
        })
    }
    commands.push({
        rx: {
            id: 0x11,
            data: [0x79],
            timeout: 1000,
            message: `Error verifying ${chunk256.length} bytes at 0x${addr256.toString(16).padStart(8, '0')}, missing final ACK`,
        }
    })
}

// Jump to the user program
commands.push({
    tx: {
        id: 0x21,
        data: [0x08, 0x00, 0x00, 0x00]
    }
}, {
    rx: {
        id: 0x21,
        data: [0x79],
        timeout: 100,
        jump: -1,
        message: "Starting the program"
    }
})

const compareArrays = (a, b) =>
    a.length === b.length && a.every((element, index) => element === b[index]);

const bar1 = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
bar1.start(commands.length, 0);

let step = 0;
let timeout_id;

function resumeSteps() {
    while (step < commands.length) {
        const cmd = commands[step];
        if (cmd.rx) {
            if (timeout_id) {
                clearTimeout(timeout_id);
            }
            timeout_id = setTimeout(() => {
                if (cmd.rx.jump && attempts > 0) {
                    // We can retry
                    attempts -= 1;
                    step += cmd.rx.jump;
                    resumeSteps();
                } else {
                    bar1.stop();
                    channel.stop();
                    console.error(cmd.rx.message);
                    exit(1);
                }
            }, cmd.rx.timeout);
            return;
        }
        if (cmd.tx) {
            channel.send({
                id: commands[step].tx.id,
                data: Buffer.from(commands[step].tx.data)
            });
            step++;
            bar1.update(step);
        }
    }
}

channel.addListener("onMessage", function (msg) {
    if (commands[step].rx) {
        if (msg.id == commands[step].rx.id && compareArrays(msg.data, commands[step].rx.data)) {
            // Mark the current RX step as complete
            if (timeout_id) {
                clearTimeout(timeout_id);
                timeout_id = undefined
            }
            step++;
            bar1.update(step);
            if (step >= commands.length) {
                bar1.stop();
                channel.stop();
                console.info("Done.");
                exit(0);
            }
            // Resume execution
            resumeSteps();
        }
    }
});

channel.disableLoopback();
channel.setRxFilters({ id: 0x0, mask: 0x0, invert: false });
channel.start();
resumeSteps();
