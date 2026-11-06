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

# fnm
FNM_PATH="/home/mikekey/.local/share/fnm"
if [ -d "$FNM_PATH" ]; then
  export PATH="$FNM_PATH:$PATH"
  eval "`fnm env`"
fi


# Import ENV
if [ -f ~/.env ]; then
    set -a
    source ~/.env
    set +a
fi

# HF cache → unified ~/models layout
export HF_HOME="$HOME/models/hf"
export HF_HUB_CACHE="$HOME/models/hf/hub"

# hipfire
export PATH="$HOME/.hipfire/bin:$PATH"
export NODE_OPTIONS="--max-old-space-size=8192"

# fnm
FNM_PATH="/home/mikekey/.local/share/fnm"
if [ -d "$FNM_PATH" ]; then
  export PATH="$FNM_PATH:$PATH"
  eval "$(fnm env --shell zsh)"
fi

# The next line updates PATH for the Google Cloud SDK.
if [ -f '/home/mikekey/google-cloud-sdk/path.zsh.inc' ]; then . '/home/mikekey/google-cloud-sdk/path.zsh.inc'; fi

# The next line enables shell command completion for gcloud.
if [ -f '/home/mikekey/google-cloud-sdk/completion.zsh.inc' ]; then . '/home/mikekey/google-cloud-sdk/completion.zsh.inc'; fi

# >>> grok installer >>>
export PATH="$HOME/.grok/bin:$PATH"
fpath=(~/.grok/completions/zsh $fpath)
autoload -Uz compinit && compinit -C
# <<< grok installer <<<
export PATH=$PATH:$HOME/.maestro/bin

# Android builds require an LTS JDK; the system default may be newer.
export JAVA_HOME="/usr/lib/jvm/java-21-openjdk"
export PATH="$JAVA_HOME/bin:$PATH"

# Android SDK
export ANDROID_HOME="$HOME/Android/Sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$PATH:$ANDROID_HOME/emulator:$ANDROID_HOME/platform-tools"

# >>> herdr-revive >>>
# Resume the coding agent a herdr terminal lost to a restart or reboot.
# REVIVE_DEBUG=1 says why it did or didn't.
if [ -n "$HC_TERMINAL_ID" ] && [ -f /home/mikekey/.config/herdr-app/mods/revive/revive.mjs ] && command -v node >/dev/null 2>&1; then
  __revive_j="$("${REVIVE_HC:-hc}" get "$HC_TERMINAL_ID" --json 2>/dev/null)"
  case "$__revive_j" in *'"revive.session"'*) __revive_has=1 ;; *) __revive_has= ;; esac
  case "$__revive_j" in *'"pid":'"$$"','*|*'"pid": '"$$"','*) __revive_own=1 ;; *) __revive_own= ;; esac
  if [ -z "$__revive_has" ]; then
    if [ -n "$REVIVE_DEBUG" ]; then echo "revive: nothing remembered on $HC_TERMINAL_ID" >&2; fi
  elif [ -z "$__revive_own" ]; then
    if [ -n "$REVIVE_DEBUG" ]; then echo "revive: not the terminal's own shell" >&2; fi
  else
    if [ -n "$REVIVE_DEBUG" ]; then __revive="$(node /home/mikekey/.config/herdr-app/mods/revive/revive.mjs check --shell $$)"
    else __revive="$(node /home/mikekey/.config/herdr-app/mods/revive/revive.mjs check --shell $$ 2>/dev/null)"; fi
    if [ -z "$__revive" ]; then unset __revive
    elif [ -n "$ZSH_VERSION" ]; then
      __revive_run() { add-zsh-hook -d precmd __revive_run; eval "$__revive"; unset __revive; unfunction __revive_run; }
      autoload -Uz add-zsh-hook && add-zsh-hook precmd __revive_run
    elif [ -n "$BASH_VERSION" ]; then
      __revive_run() { PROMPT_COMMAND="${PROMPT_COMMAND#__revive_run;}"; eval "$__revive"; unset __revive; unset -f __revive_run; }
      PROMPT_COMMAND="__revive_run;${PROMPT_COMMAND}"
    else eval "$__revive"; unset __revive; fi
  fi
  unset __revive_j __revive_has __revive_own
fi
# <<< herdr-revive <<<
