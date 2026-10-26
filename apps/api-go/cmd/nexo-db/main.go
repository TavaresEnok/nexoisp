package main

import (
	"context"
	"fmt"
	"nexoisp/api-go/internal/cryptox"
	"nexoisp/api-go/internal/db"
	"os"
	"time"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "uso: nexo-db prepare | bootstrap [--init-app-role] | baseline | up | jobs-up | verificar | create-operator <email> <nome> | rotate-secrets | preflight | verify-restore | seed-demo | totp <segredo>")
		os.Exit(2)
	}
	if os.Args[1] == "totp" {
		if len(os.Args) != 3 {
			fmt.Fprintln(os.Stderr, "uso: nexo-db totp <segredo>")
			os.Exit(2)
		}
		code, e := cryptox.TOTPCode(os.Args[2], time.Now())
		if e != nil {
			fmt.Fprintln(os.Stderr, "segredo TOTP inválido")
			os.Exit(1)
		}
		fmt.Println(code)
		return
	}
	if os.Args[1] == "create-operator" || os.Args[1] == "rotate-secrets" || os.Args[1] == "preflight" || os.Args[1] == "seed-demo" || os.Args[1] == "verify-restore" {
		if err := db.Operate(context.Background(), os.Args[1:], os.Stdout); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	if os.Args[1] == "jobs-up" {
		if err := db.JobsMigrate(context.Background(), os.Getenv("DATABASE_URL_OWNER")); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		fmt.Println("jobs-up: ok")
		return
	}
	root, err := db.Root()
	if err == nil && os.Args[1] == "prepare" {
		err = db.Prepare(context.Background(), root)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		fmt.Println("prepare: ok")
		return
	}
	if err == nil {
		err = db.Admin(context.Background(), os.Args[1], root, len(os.Args) > 2 && os.Args[2] == "--init-app-role")
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Println(os.Args[1] + ": ok")
}
