const asyncHandler = require("express-async-handler");
const User = require("../models/user");

const getUserProfile = asyncHandler(async (req, res) => {
  const { devToken } = req.body;

  try {
    const user = await User.findOne({ devToken: devToken });
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }
    res.status(200).json({ success: true, message: "User found", data: user });
  } catch (error) {
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

module.exports = {
  getUserProfile,
};
