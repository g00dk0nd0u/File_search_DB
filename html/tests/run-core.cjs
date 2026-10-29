"use strict";
const S = require("../search.js");
const FS = require("../filesystem.js");
require("./core-tests.js")(S, FS)
  .then(async (result) => { await require("./filter-contract.cjs")(S); await require("./search-contract.cjs")(S); console.log(JSON.stringify({...result, filterContract:"passed", searchContract:"passed"})); })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
