fn main() {
    if let Err(error) = sigyn::run_cli() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
