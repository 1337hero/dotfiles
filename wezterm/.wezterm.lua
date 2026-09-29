-- Pull in the wezterm API
local wezterm = require 'wezterm'

-- This will hold the configuration.
local config = wezterm.config_builder()

config.color_scheme = "Catppuccin Mocha"
config.window_background_opacity = .95
config.enable_wayland = false
config.font = wezterm.font('MonoLisa', { weight = 'Light' })
config.font_size = 14.0

-- Enable Kitty keyboard protocol (CSI-u) so modified keys are distinguishable
config.enable_csi_u_key_encoding = true

return config
