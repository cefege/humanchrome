//! Native HumanChrome CLI; production installation is never implicit.

use humanchrome_native::cli::{RegistrationContext, execute, parse_args};
use std::io::{self, Write};

#[tokio::main]
async fn main() -> std::process::ExitCode {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    let command = match parse_args(&args) {
        Ok(command) => command,
        Err(error) => {
            eprintln!("{error}");
            return std::process::ExitCode::from(2);
        }
    };
    let context = match RegistrationContext::from_environment() {
        Ok(context) => context,
        Err(error) => {
            eprintln!("unable to resolve native installation paths: {error}");
            return std::process::ExitCode::FAILURE;
        }
    };
    let output = execute(&context, &command).await;
    if !output.stdout.is_empty() {
        let _ = io::stdout().write_all(output.stdout.as_bytes());
    }
    if !output.stderr.is_empty() {
        let _ = io::stderr().write_all(output.stderr.as_bytes());
    }
    std::process::ExitCode::from(output.exit_code)
}
