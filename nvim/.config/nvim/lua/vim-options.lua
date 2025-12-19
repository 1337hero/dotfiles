local opt = vim.opt -- for conciseness

opt.relativenumber = true
opt.number = true
opt.tabstop = 2
opt.shiftwidth = 2
opt.expandtab = true

opt.autoindent = true
opt.wrap = false
opt.ignorecase = true
opt.smartcase = true
opt.cursorline = true
opt.backspace = "indent,eol,start"
opt.clipboard:append("unnamedplus")
opt.termguicolors = true
opt.splitright = true
opt.splitbelow = true
opt.hlsearch = false
opt.incsearch = true
opt.swapfile = false
opt.foldcolumn = "0"
opt.foldlevel = 99
opt.foldlevelstart = 99
opt.foldenable = true
opt.scrolloff = 8


opt.guicursor = {
	"n-v-c:block", -- Normal, visual, command-line: block cursor
	"i-ci-ve:ver25", -- Insert, command-line insert, visual-exclude: vertical bar cursor with 25% width
	"r-cr:hor20", -- Replace, command-line replace: horizontal bar cursor with 20% height
	"o:hor50", -- Operator-pending: horizontal bar cursor with 50% height
	"a:blinkwait700-blinkoff400-blinkon250", -- All modes: blinking settings
	"sm:block-blinkwait175-blinkoff150-blinkon175", -- Showmatch: block cursor with specific blinking settings
}



-- local keymap = vim.keymap -- for conciseness


-- keymap.set('n', '<leader>h', ':nohlsearch<CR>')
-- keymap.set("n", "<leader>+", "<C-a>", { desc = "Increment number" })
-- keymap.set("n", "<leader>-", "<C-x>", { desc = "Decrement number" })
-- keymap.set("n", "<leader>sv", "<C-w>v", { desc = "Split window vertically" })
-- keymap.set("n", "<leader>sh", "<C-w>s", { desc = "Split window horizontally" })
-- keymap.set("n", "<leader>se", "<C-w>=", { desc = "Make splits equal size" })
-- keymap.set("n", "<leader>sx", "<cmd>close<CR>", { desc = "Close current split" })
-- keymap.set("n", "<leader>to", "<cmd>tabnew<CR>", { desc = "Open new tab" })
-- keymap.set("n", "<leader>tx", "<cmd>tabclose<CR>", { desc = "Close current tab" })
-- keymap.set("n", "<leader>tn", "<cmd>tabn<CR>", { desc = "Go to next tab" })
-- keymap.set("n", "<leader>tp", "<cmd>tabp<CR>", { desc = "Go to previous tab" })
-- keymap.set("n", "<leader>tf", "<cmd>tabnew %<CR>", { desc = "Open current buffer in new tab" })

vim.wo.number = true
