"use strict";
const S = require("../search.js");
const FS = require("../filesystem.js");
require("./core-tests.js")(S, FS)
  .then((result) => console.log(JSON.stringify(result)))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
