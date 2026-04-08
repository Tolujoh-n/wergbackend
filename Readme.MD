# Admin and supper admin

Create admin account:
`npm run create:privileged-user -- --role admin --username admin2 --email admin2@wergame.com --password "StrongPass123"`

Create super admin account:
`npm run create:privileged-user -- --role superAdmin --username boss --email boss@wergame.com --password "StrongPass123"`

Update an admin/supper account
`npm run create:privileged-user -- --role admin --username admin2 --email admin2@wergame.com --password "NewStrongPass123" --update`


set a wallet address:
`npm run create:privileged-user -- --role superAdmin --username boss --email boss@wergame.com --password "StrongPass123" --walletAddress 0xabc... --update`

