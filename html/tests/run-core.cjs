"use strict";
const S = require("../search.js");
const FS = require("../filesystem.js");
require("./core-tests.js")(S, FS)
  .then(async (result) => { await require("./filter-contract.cjs")(S); console.log(JSON.stringify({...result, filterContract:"passed"})); })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
