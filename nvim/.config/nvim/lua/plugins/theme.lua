-- return {
--   {
--     "folke/tokyonight.nvim",
--     lazy = false,
--     priority = 1000,
--     opts = {
--     },
--   }
-- }
return {
{
    "catppuccin/nvim",

    name = "catppuccin",
    --"folke/tokyonight.nvim",
    --"rebelot/kanagawa.nvim",

    lazy = false,
    priority = 1000,

    opts = {
       integrations = {
        cmp = true,
        gitsigns = true,
        neotree = true,
        treesitter = true,
        harpoon = true,
        notify = false,
        mini = {
            enabled = true,
            indentscope_color = "",
        },
      }
    },
    config = function()
        vim.cmd [[colorscheme catppuccin-macchiato]]
    end,
}
}
