//! Process-level contract oracle; never installed as a native host.

use std::io::{self, Write};

fn main() -> io::Result<()> {
    let mut stdout = io::stdout().lock();
    stdout.write_all(humanchrome_contracts::CONTRACT_JSON.as_bytes())
}
