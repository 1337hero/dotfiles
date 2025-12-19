return {
    {
        "nvim-neo-tree/neo-tree.nvim",
        branch = "v3.x",
        keys = { -- only load the plugin on these keymaps
            {"<C-n>", "<CMD>Neotree filesystem reveal left<CR>"},
            {"<leader>bf", "<CMD>Neotree buffers reveal float<CR>"}
        },
        dependencies = {
            "nvim-lua/plenary.nvim", "nvim-tree/nvim-web-devicons",
            "MunifTanjim/nui.nvim"
        },
        opts = {
            enable_git_status = true,
            enable_diagnostics = true,
            filesystem = {
                filtered_items = {
                    visible = false,
                    show_hidden_count = false,
                    hide_dotfiles = false,
                    hide_gitignored = false,
                    hide_by_name = {'.git', '.DS_Store', 'thumbs.db'},
                    never_show = {}
                }
            },
            indent = {
                indent_size = 2,
                padding = 1,
                with_markers = true,
                indent_marker = "│",
                last_indent_marker = "└",
                highlight = "NeoTreeIndentMarker",
                with_expanders = nil,
                expander_collapsed = "",
                expander_expanded = "",
                expander_highlight = "NeoTreeExpander"
            },
            icon = {
                folder_closed = "",
                folder_open = "",
                folder_empty = "󰜌",
                default = "*",
                highlight = "NeoTreeFileIcon"
            },
            window = {
                position = "left",
                width = 20,
                mapping_options = {noremap = true, nowait = true}
            }

        }
    }
}
