# ijt-shell-integration (zprofile)
#
# See zshenv.zsh for the rationale on the trailing `:`.
{
  _ijt_user_zdotdir="${IJT_USER_ZDOTDIR:-$HOME}"
  [ -f "$_ijt_user_zdotdir/.zprofile" ] && source "$_ijt_user_zdotdir/.zprofile"
  unset _ijt_user_zdotdir
}
:
