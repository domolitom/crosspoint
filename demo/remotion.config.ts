import { Config } from '@remotion/cli/config';

Config.setVideoImageFormat('jpeg');
Config.setOverwriteOutput(true);
// Playwright's Chromium is already on this machine; no reason to download a second one.
Config.setChromiumOpenGlRenderer('angle');
