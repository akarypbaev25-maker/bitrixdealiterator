// index.ts — entrypoint for Render
import "./server"; // server will start listening
import "./bot";    // bot will launch
import { info } from "./logger";

info("Application started (server + bot).");
