# fish reads its normal configuration before --init-command. Native events keep
# the user's prompt, key bindings and history policy in charge.
if test "$ELEVENEX_TERMINAL_SHELL_INTEGRATION" = 0
    builtin printf '\e]133;X;__ELEVENEX_TOKEN__\a'
    return
end
builtin cd -- "$ELEVENEX_USER_CWD"; or return
function _elevenex_user_escape
    # string split owns command-substitution splitting, including newline
    # characters. Emit one escaped value without lossy line-oriented pipelines.
    for character in (string split '' -- "$argv[1]")
        if test "$character" = '\\'
            builtin printf '%s' '\\\\'
        else if test "$character" = ';'
            builtin printf '%s' '\\x3b'
        else if test "$character" = \n
            builtin printf '%s' '\\x0a'
        else if test "$character" = \t
            builtin printf '%s' '\\x09'
        else
            builtin printf '%s' "$character"
        end
    end
end
function _elevenex_user_start --on-event fish_preexec
    set -l command "$argv[1]"
    if test (string length -- "$command") -gt 4096
        set command ''
    end
    set -g _elevenex_user_executing 1
    builtin printf '\e]133;E;__ELEVENEX_TOKEN__;%s\a\e]133;C;__ELEVENEX_TOKEN__\a' (_elevenex_user_escape "$command" | string collect --allow-empty)
end
function _elevenex_user_finish --on-event fish_postexec
    set -l result $status
    set -e _elevenex_user_executing
    builtin printf '\e]133;D;__ELEVENEX_TOKEN__;%s\a' $result
    return $result
end
function _elevenex_user_cancel --on-event fish_cancel
    if set -q _elevenex_user_executing
        set -e _elevenex_user_executing
        builtin printf '\e]133;D;__ELEVENEX_TOKEN__;130\a'
    end
end
function _elevenex_user_ready --on-event fish_prompt
    set -l result $status
    set -l directory "$PWD"
    if test (string length -- "$directory") -gt 8192
        set directory ''
    end
    builtin printf '\e]133;P;__ELEVENEX_TOKEN__;%s\a' (_elevenex_user_escape "$directory" | string collect --allow-empty)
    return $result
end
# A fish_prompt event precedes rendering. Wrap the existing prompt without
# replacing its editing/history policy, and grant input only after it returns.
if functions --copy fish_prompt _elevenex_user_original_prompt
    function fish_prompt
        _elevenex_user_original_prompt
        set -l result $status
        builtin printf '\e]133;B;__ELEVENEX_TOKEN__\a'
        return $result
    end
end
