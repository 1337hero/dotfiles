-- Pull in the wezterm API
local wezterm = require 'wezterm'

-- This will hold the configuration.
local config = wezterm.config_builder()


config.color_scheme = "Catppuccin Mocha"
config.window_background_opacity = 1
config.enable_wayland = false
config.font = wezterm.font('MonoLisa', { weight = 'Light' })
config.font_size = 14.0

-- and finally, return the configuration to wezterm
config.keys = {
  {key="Enter", mods="SHIFT", action=wezterm.action{SendString="\x1b\r"}},
}

return config
