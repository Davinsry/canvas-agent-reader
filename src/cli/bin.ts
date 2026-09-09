#!/usr/bin/env node
import "dotenv/config";
import { createCli } from "./commands.js";

const cli = createCli();
cli.parse(process.argv);