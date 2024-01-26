const express = require("express");
const { getUserProfile } = require("../controllers/api");
const router = express.Router();

router.post("/userProfile", getUserProfile);

module.exports = router;
