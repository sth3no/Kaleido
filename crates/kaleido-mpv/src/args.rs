/// Options and files from an mpv-style command line.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Invocation {
    pub options: Vec<(String, String)>,
    pub files: Vec<String>,
}

/// `--name=value` → (name, value); `--no-name` → (name, "no"); `--name` → (name, "yes");
/// everything after `--` and every bare argument is a file.
pub fn parse_args<I: IntoIterator<Item = String>>(args: I) -> Invocation {
    let mut inv = Invocation::default();
    let mut files_only = false;
    for arg in args {
        if files_only {
            inv.files.push(arg);
            continue;
        }
        if arg == "--" {
            files_only = true;
            continue;
        }
        let Some(option) = arg.strip_prefix("--") else {
            inv.files.push(arg);
            continue;
        };
        let pair = match option.split_once('=') {
            Some((name, value)) => (name.to_owned(), value.to_owned()),
            None => match option.strip_prefix("no-") {
                Some(name) => (name.to_owned(), "no".to_owned()),
                None => (option.to_owned(), "yes".to_owned()),
            },
        };
        inv.options.push(pair);
    }
    inv
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Invocation {
        parse_args(args.iter().map(|a| a.to_string()))
    }

    fn opt(name: &str, value: &str) -> (String, String) {
        (name.to_owned(), value.to_owned())
    }

    #[test]
    fn thumbfast_style_command_line() {
        let inv = parse(&[
            "--no-config",
            "--msg-level=all=no",
            "--idle",
            "--vf=scale=w=200:h=-2,format=fmt=bgra",
            "--start=12.5",
            "--",
            r"C:\Videa\film --x.mkv",
        ]);
        assert_eq!(
            inv.options,
            vec![
                opt("config", "no"),
                opt("msg-level", "all=no"),
                opt("idle", "yes"),
                opt("vf", "scale=w=200:h=-2,format=fmt=bgra"),
                opt("start", "12.5"),
            ]
        );
        assert_eq!(inv.files, vec![r"C:\Videa\film --x.mkv".to_owned()]);
    }

    #[test]
    fn bare_arguments_are_files() {
        let inv = parse(&["a.mkv", "--pause", "b.mkv"]);
        assert_eq!(inv.options, vec![opt("pause", "yes")]);
        assert_eq!(inv.files, vec!["a.mkv".to_owned(), "b.mkv".to_owned()]);
    }

    #[test]
    fn double_dash_turns_options_into_files() {
        let inv = parse(&["--", "--no-config"]);
        assert!(inv.options.is_empty());
        assert_eq!(inv.files, vec!["--no-config".to_owned()]);
    }

    #[test]
    fn empty_value_is_kept() {
        assert_eq!(parse(&["--o="]).options, vec![opt("o", "")]);
    }
}
