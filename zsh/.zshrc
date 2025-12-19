unset zle_bracketed_paste

autoload -Uz compinit && compinit

source  /home/mikekey/Dotfiles/zsh/.aliases
source  /home/mikekey/Dotfiles/zsh/.history
source  /home/mikekey/Dotfiles/zsh/.zsh-git
source  /home/mikekey/Dotfiles/zsh/.zsh-theme

HISTFILE=$HOME/.zsh_history
HISTSIZE=1000
SAVEHIST=1000

# Changing/making/removing directory
setopt auto_cd
setopt auto_pushd
setopt pushd_ignore_dups
setopt pushdminus

function d () {
  if [[ -n $1 ]]; then
    dirs "$@"
  else
    dirs -v | head -n 10
  fi
}
compdef _dirs d

git_prompt() {
  BRANCH=$(git branch 2> /dev/null | sed -e '/^[^*]/d' -e 's/*\(.*\)/\1/')

  if [ ! -z $BRANCH ]; then
    echo -n "%F{yellow}$BRANCH"

    STATUS=$(git status --short 2> /dev/null)

    if [ ! -z "$STATUS" ]; then
      echo " %F{red}✗"
    fi
  fi
}

#Bullet Train Theme Options
BULLETTRAIN_PROMPT_CHAR="%F{white}%} 󱞩  "
BULLETTRAIN_DIR_BG=#eed49f 
BULLETTRAIN_DIR_FG=black
BULLETTRAIN_CUSTOM_BG=#cad3f5
BULLETTRAIN_CUSTOM_FG=black
BULLETTRAIN_GIT_BG=#a6da95
BULLETTRAIN_CUSTOM_MSG=󰣇
BULLETTRAIN_PROMPT_ORDER=(
  #time
  custom
  status
  #context
  dir
  screen
  rust
  react
  preact
  git
)

# New content
# ZSH completion
autoload -Uz compinit
compinit
neofetch

# Add /usr/local/bin to PATH
export PATH="/usr/local/bin:$PATH"

# Ruby Gems
export PATH="$PATH:$HOME/.local/share/gem/ruby/3.4.0/bin"

# NVM setup
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"  # This loads nvm
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"  # This loads nvm bash_completion

# Bun setup
export BUN_INSTALL="$HOME/.bun"
export PATH=$BUN_INSTALL/bin:$PATH

# Neovim setup
export PATH="$PATH:/opt/nvim-linux64/bin"

# bun completions
[ -s "/home/mikekey/.bun/_bun" ] && source "/home/mikekey/.bun/_bun"

# Linux Crud
export PATH=$PATH:/opt/rocm/bin
export ROCM_PATH=/opt/rocm
export HIP_PLATFORM=amd
export HIP_PLATFORM=amd
export LD_LIBRARY_PATH=$LD_LIBRARY_PATH:/opt/rocm/lib


. "$HOME/.local/bin/env"
