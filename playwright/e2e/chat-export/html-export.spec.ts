/*
Copyright 2024 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import os from "node:os";
import path from "node:path";
import * as fsp from "node:fs/promises";
import * as fs from "node:fs";
import JSZip from "jszip";

import { test, expect } from "../../element-web-test";

// Based on https://github.com/Stuk/jszip/issues/466#issuecomment-2097061912
async function extractZipFileToPath(file: string, outputPath: string): Promise<JSZip> {
    if (!fs.existsSync(outputPath)) {
        fs.mkdirSync(outputPath, { recursive: true });
    }

    const data = await fsp.readFile(file);
    const zip = await JSZip.loadAsync(data, { createFolders: true });

    await new Promise<void>((resolve, reject) => {
        let entryCount = 0;
        let errorOut = false;

        zip.forEach(() => {
            entryCount++;
        }); // there is no other way to count the number of entries within the zip file.

        zip.forEach((relativePath, zipEntry) => {
            if (errorOut) {
                return;
            }

            const outputEntryPath = path.join(outputPath, relativePath);
            if (zipEntry.dir) {
                if (!fs.existsSync(outputEntryPath)) {
                    fs.mkdirSync(outputEntryPath, { recursive: true });
                }

                entryCount--;

                if (entryCount === 0) {
                    resolve();
                }
            } else {
                void zipEntry
                    .async("blob")
                    .then(async (content) => Buffer.from(await content.arrayBuffer()))
                    .then((buffer) => {
                        const stream = fs.createWriteStream(outputEntryPath);
                        stream.write(buffer, (error) => {
                            if (error) {
                                reject(error);
                                errorOut = true;
                            }
                        });
                        stream.on("finish", () => {
                            entryCount--;

                            if (entryCount === 0) {
                                resolve();
                            }
                        });
                        stream.end(); // extremely important on Windows. On Mac / Linux, not so much since those platforms allow multiple apps to read from the same file. Windows doesn't allow that.
                    })
                    .catch((e) => {
                        errorOut = true;
                        reject(e);
                    });
            }
        });
    });

    return zip;
}

test.describe("HTML Export", () => {
    test.use({
        displayName: "Alice",
        room: async ({ app, user }, use) => {
            const roomId = await app.client.createRoom({ name: "Important Room" });
            await app.viewRoomByName("Important Room");
            await use({ roomId });
        },
    });

    test("should export html successfully and match screenshot", async ({ page, app, room }) => {
        // Send a bunch of messages to populate the room
        for (let i = 1; i < 10; i++) {
            await app.client.sendMessage(room.roomId, { body: `Testing ${i}`, msgtype: "m.text" });
        }

        // Wait for all the messages to be displayed
        await expect(
            page.locator(".mx_EventTile_last .mx_MTextBody .mx_EventTile_body").getByText("Testing 9"),
        ).toBeVisible();

        await page.getByRole("button", { name: "Room info" }).click();
        await page.getByRole("menuitem", { name: "Export Chat" }).click();

        const downloadPromise = page.waitForEvent("download");
        await page.getByRole("button", { name: "Export", exact: true }).click();
        const download = await downloadPromise;

        const dirPath = path.join(os.tmpdir(), "html-export-test");
        const zipPath = `${dirPath}.zip`;
        await download.saveAs(zipPath);

        const zip = await extractZipFileToPath(zipPath, dirPath);
        await page.goto(`file://${dirPath}/${Object.keys(zip.files)[0]}/messages.html`);
        await expect(page).toMatchScreenshot("html-export.png", {
            mask: [
                page.getByText("This is the start of export", { exact: false }),
                // We need to mask the whole thing because the width of the time part changes
                page.locator(".mx_TimelineSeparator"),
                page.locator(".mx_MessageTimestamp"),
            ],
        });
    });
});
